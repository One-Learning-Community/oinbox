import re,sys
# usage: blocks.py BRIEF            -> list blocks;  blocks.py BRIEF N OUT -> write block N to OUT
s=open(sys.argv[1]).read()
bl=re.findall(r"```(\w*)\n(.*?)```", s, re.S)
if len(sys.argv)==2:
    for i,(lang,b) in enumerate(bl): print(i,lang,len(b.split('\n')),b.split('\n')[0][:70])
else:
    open(sys.argv[3],'w').write(bl[int(sys.argv[2])][1])
